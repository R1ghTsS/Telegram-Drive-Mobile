/**
 * telegramService.js
 * All Telegram operations — runs gramjs DIRECTLY (no proxy server).
 * Native Android compatible: no browser-only APIs used.
 *
 * IMPORTANT: Api and computeCheck are lazy-loaded via require() inside
 * functions to avoid initializing telegram/gramjs before React Native's
 * native bridge is ready (which causes "Cannot read property 'slice'" crashes).
 */
import { Platform } from 'react-native';
import { gramClient } from './gramClient';

// Lazy-load to avoid early initialization
function getApi() {
  return require('telegram').Api;
}

function getComputeCheck() {
  return require('telegram/Password').computeCheck;
}

const TD_TAG   = ' [TD]';
const TD_ABOUT = 'Telegram Drive Storage\n[telegram-drive-folder]';

// ─── Formatting ───────────────────────────────────────────────────────────────

export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '—';
  if (bytes < 1024)               return `${bytes} B`;
  if (bytes < 1048576)            return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824)         return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function detectType(mimeType, attributes) {
  if (!mimeType) return 'document';
  const hasVideo = attributes?.some(a => a.className === 'DocumentAttributeVideo');
  if (hasVideo || mimeType.startsWith('video/'))       return 'video';
  if (mimeType.startsWith('image/'))                   return 'image';
  if (mimeType === 'application/pdf')                  return 'pdf';
  if (mimeType.startsWith('audio/'))                   return 'audio';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) return 'archive';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'word';
  if (mimeType.includes('sheet') || mimeType.includes('excel'))   return 'excel';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'ppt';
  if (mimeType.startsWith('text/'))                    return 'text';
  return 'document';
}

function formatMsg(msg) {
  if (!msg?.media) return null;
  const media = msg.media;
  let name = 'Unknown', size = 0, type = 'file', mimeType = '';

  if (media.document) {
    const doc = media.document;
    const fnAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');
    name     = fnAttr?.fileName || `file_${msg.id}`;
    size     = Number(doc.size || 0);
    mimeType = doc.mimeType || '';
    type     = detectType(mimeType, doc.attributes);
  } else if (media.photo) {
    name     = `photo_${msg.id}.jpg`;
    type     = 'image';
    mimeType = 'image/jpeg';
  }

  const ext  = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const date = msg.date ? new Date(msg.date * 1000) : null;
  const dateStr = date
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  return {
    id: String(msg.id),
    name,
    size,
    sizeStr: formatBytes(size),
    type,
    mimeType,
    ext,
    date: dateStr,
    rawDate: msg.date || 0,
  };
}

// ─── Entity resolution ────────────────────────────────────────────────────────

async function getEntity(folderId) {
  const client = gramClient.get();
  if (!folderId) return 'me';
  const cached = gramClient.getCachedEntity(String(folderId));
  if (cached)   return cached;
  try {
    const entity = await client.getEntity(BigInt(folderId));
    gramClient.cacheEntity(String(folderId), entity);
    return entity;
  } catch {
    return String(folderId);
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function requestLoginCode(apiId, apiHash, phone) {
  console.log('[TG Auth] requestLoginCode start — phone:', phone);
  try {
    console.log('[TG Auth] Calling gramClient.init...');
    await gramClient.init(apiId, apiHash);
    console.log('[TG Auth] gramClient.init OK — connected');
  } catch (e) {
    console.error('[TG Auth] gramClient.init FAILED:', e.message, e.stack);
    throw e;
  }
  const client = gramClient.get();
  gramClient._phone   = phone;
  gramClient._apiId   = apiId;
  gramClient._apiHash = apiHash;
  try {
    console.log('[TG Auth] Calling client.sendCode...');
    const result = await client.sendCode({ apiId: parseInt(apiId, 10), apiHash }, phone);
    console.log('[TG Auth] sendCode OK — phoneCodeHash:', result?.phoneCodeHash ? 'present' : 'MISSING');
    gramClient._phoneCodeHash = result.phoneCodeHash;
  } catch (e) {
    console.error('[TG Auth] sendCode FAILED:', e.message, e.stack);
    throw e;
  }
}

export async function signInWithCode(_apiId, _apiHash, _phone, code) {
  const Api = getApi();
  const client = gramClient.get();
  try {
    await client.invoke(new Api.auth.SignIn({
      phoneNumber:   gramClient._phone,
      phoneCodeHash: gramClient._phoneCodeHash,
      phoneCode:     code,
    }));
    await gramClient.saveSession();
    return { success: true };
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes('SESSION_PASSWORD_NEEDED')) return { success: false, nextStep: 'password' };
    throw err;
  }
}

export async function checkPassword(password) {
  const Api = getApi();
  const computeCheck = getComputeCheck();
  const client = gramClient.get();
  const pwInfo = await client.invoke(new Api.account.GetPassword());
  const check  = await computeCheck(pwInfo, password);
  await client.invoke(new Api.auth.CheckPassword({ password: check }));
  await gramClient.saveSession();
  return { success: true };
}

export async function restoreSession() {
  const { session, apiId, apiHash } = await gramClient.getSaved();
  if (!session || !apiId || !apiHash) return null;
  try {
    gramClient._apiId   = apiId;
    gramClient._apiHash = apiHash;
    await gramClient.init(apiId, apiHash, session);
    return await getMe();
  } catch {
    await gramClient.clearSession();
    return null;
  }
}

export async function logout() {
  const Api = getApi();
  try { await gramClient.get().invoke(new Api.auth.LogOut()); } catch {}
  await gramClient.clearSession();
}

export async function getMe() {
  const client = gramClient.get();
  const me     = await client.getMe();
  return {
    id:       me.id?.toString(),
    name:     [me.firstName, me.lastName].filter(Boolean).join(' '),
    phone:    me.phone,
    username: me.username || null,
  };
}

// ─── Folders ──────────────────────────────────────────────────────────────────

export async function getFolders() {
  const client  = gramClient.get();
  const dialogs = await client.getDialogs({ limit: 200 });
  const folders = [];
  for (const d of dialogs) {
    if (!d.isChannel || d.isGroup) continue;
    const title = d.title || '';
    if (title.match(/\[TD\]/i)) {
      gramClient.cacheEntity(String(d.id), d.entity);
      folders.push({ id: String(d.id), name: title.replace(/\s*\[TD\]/gi, '').trim() });
    }
  }
  return folders;
}

export async function createFolder(name) {
  const Api = getApi();
  const client = gramClient.get();
  const result = await client.invoke(new Api.channels.CreateChannel({
    broadcast:  true,
    megagroup:  false,
    title:      `${name}${TD_TAG}`,
    about:      TD_ABOUT,
    forImport:  false,
    forum:      false,
  }));
  const channel = result.chats?.[0];
  if (!channel) throw new Error('Failed to create folder');
  // Disable auto-delete TTL
  try {
    await client.invoke(new Api.messages.SetHistoryTtl({
      peer:   new Api.InputPeerChannel({ channelId: channel.id, accessHash: channel.accessHash }),
      period: 0,
    }));
  } catch {}
  gramClient.cacheEntity(String(channel.id), channel);
  return { id: String(channel.id), name };
}

export async function deleteFolder(folderId) {
  const Api = getApi();
  const client = gramClient.get();
  const entity = await getEntity(folderId);
  await client.invoke(new Api.channels.DeleteChannel({ channel: entity }));
  return true;
}

export const syncFolders = getFolders;

// ─── Files ────────────────────────────────────────────────────────────────────

export async function getFiles(folderId = null, limit = 100) {
  const client   = gramClient.get();
  const entity   = await getEntity(folderId);
  const messages = await client.getMessages(entity, { limit });
  return messages.filter(m => m.media).map(formatMsg).filter(Boolean);
}

export async function deleteFile(messageId, folderId = null) {
  const client = gramClient.get();
  const entity = await getEntity(folderId);
  await client.deleteMessages(entity, [parseInt(messageId, 10)], { revoke: true });
  return true;
}

export async function moveFiles(messageIds, sourceFolderId, targetFolderId) {
  const Api = getApi();
  const client       = gramClient.get();
  const sourceEntity = await getEntity(sourceFolderId);
  const targetEntity = await getEntity(targetFolderId);
  const ids          = messageIds.map(id => parseInt(id, 10));

  await client.invoke(new Api.messages.ForwardMessages({
    fromPeer: sourceEntity,
    id:       ids,
    toPeer:   targetEntity,
    randomId: ids.map(() => BigInt(Math.floor(Math.random() * 1e15))),
    dropAuthor: true,
  }));
  await client.deleteMessages(sourceEntity, ids, { revoke: true });
  return true;
}

export async function searchFiles(query, folderId = null) {
  const client   = gramClient.get();
  const entity   = await getEntity(folderId || 'me');
  const messages = await client.getMessages(entity, { search: query, limit: 50 });
  return messages.filter(m => m.media).map(formatMsg).filter(Boolean);
}

export async function searchGlobal(query) {
  const Api = getApi();
  const client = gramClient.get();
  try {
    const result = await client.invoke(new Api.messages.SearchGlobal({
      q:           query,
      filter:      new Api.InputMessagesFilterDocument(),
      minDate:     0,
      maxDate:     0,
      offsetRate:  0,
      offsetPeer:  new Api.InputPeerEmpty(),
      offsetId:    0,
      limit:       50,
    }));
    return (result.messages || []).map(formatMsg).filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Upload ───────────────────────────────────────────────────────────────────

export async function uploadFile(file, folderId = null, onProgress = null) {
  const client = gramClient.get();
  const entity = await getEntity(folderId);

  let fileToSend = file;

  // Native: expo-document-picker gives { uri, name, mimeType, _isNative }
  // gramjs sendFile needs a Buffer (with a .name property) on native
  if (file && file._isNative && file.uri) {
    const { FileSystem }  = await import('expo-file-system');
    const base64          = await FileSystem.readAsStringAsync(file.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const bytes           = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    fileToSend            = Buffer.from(bytes);
    fileToSend.name       = file.name;
  }

  await client.sendFile(entity, {
    file:          fileToSend,
    forceDocument: true,
    workers:       4,
    onProgress:    p => onProgress && onProgress(Math.round(p * 100)),
  });
  return true;
}

// ─── Download / Preview ───────────────────────────────────────────────────────

export async function downloadFile(messageId, folderId = null, filename = 'file') {
  const client   = gramClient.get();
  const entity   = await getEntity(folderId);
  const messages = await client.getMessages(entity, { ids: [parseInt(messageId, 10)] });
  const msg      = messages?.[0];
  if (!msg?.media) throw new Error('Message not found');

  const buffer = await client.downloadMedia(msg.media, { workers: 4 });

  if (Platform.OS === 'web') {
    // Web: use browser download APIs
    const blob = new Blob([buffer]);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } else {
    // Native Android/iOS: write to cache then share
    const { FileSystem } = await import('expo-file-system');
    const { shareAsync }  = await import('expo-sharing');
    const fileUri = FileSystem.cacheDirectory + filename;
    await FileSystem.writeAsStringAsync(fileUri, buffer.toString('base64'), {
      encoding: FileSystem.EncodingType.Base64,
    });
    await shareAsync(fileUri, { mimeType: 'application/octet-stream', dialogTitle: `Save ${filename}` });
  }
  return true;
}

/**
 * Downloads media and returns a typed Blob URL.
 * onProgress(0–100) is called as chunks arrive.
 * mimeType is set on the Blob so the browser can play it natively.
 */
export async function getMediaUrl(messageId, folderId = null, mimeType = '', onProgress = null) {
  const client   = gramClient.get();
  const entity   = await getEntity(folderId);
  const messages = await client.getMessages(entity, { ids: [parseInt(messageId, 10)] });
  const msg      = messages?.[0];
  if (!msg?.media) return null;

  // Resolve MIME from the media object if not supplied
  let resolvedMime = mimeType;
  if (!resolvedMime && msg.media.document) resolvedMime = msg.media.document.mimeType || '';
  if (!resolvedMime && msg.media.photo)    resolvedMime = 'image/jpeg';

  const buffer = await client.downloadMedia(msg.media, {
    workers: 4,
    progressCallback: onProgress
      ? (dl, total) => {
          const t = Number(total), d = Number(dl);
          if (t > 0) onProgress(Math.min(99, Math.round((d / t) * 100)));
        }
      : undefined,
  });
  if (!buffer) return null;
  onProgress?.(100);

  if (Platform.OS === 'web') {
    return URL.createObjectURL(new Blob([buffer], { type: resolvedMime || 'application/octet-stream' }));
  }
  // Native: write buffer to cache file and return local URI
  try {
    const { FileSystem } = await import('expo-file-system');
    const ext     = resolvedMime.split('/')[1] || 'bin';
    const fileUri = FileSystem.cacheDirectory + `media_${messageId}.${ext}`;
    await FileSystem.writeAsStringAsync(fileUri, buffer.toString('base64'), {
      encoding: FileSystem.EncodingType.Base64,
    });
    return fileUri;
  } catch {
    return null;
  }
}

/** Legacy helper kept for image previews */
export async function getPreviewUrl(messageId, folderId = null) {
  return getMediaUrl(messageId, folderId, '', null);
}

/**
 * Downloads only the SMALLEST thumbnail for a media message.
 * Much faster than downloading the full image — used for file-list thumbnails.
 * Returns a blob URL or null.
 */
export async function getThumbnailUrl(messageId, folderId = null) {
  const client   = gramClient.get();
  const entity   = await getEntity(folderId);
  const messages = await client.getMessages(entity, { ids: [parseInt(messageId, 10)] });
  const msg      = messages?.[0];
  if (!msg?.media) return null;

  const _bufToUri = async (buffer, mime) => {
    if (!buffer || buffer.length === 0) return null;
    if (Platform.OS === 'web') {
      return URL.createObjectURL(new Blob([buffer], { type: mime }));
    }
    // Native: cache to disk
    const { FileSystem } = await import('expo-file-system');
    const fileUri = FileSystem.cacheDirectory + `thumb_${messageId}.jpg`;
    await FileSystem.writeAsStringAsync(fileUri, buffer.toString('base64'), {
      encoding: FileSystem.EncodingType.Base64,
    });
    return fileUri;
  };

  try {
    // thumb: 0 → smallest available size (fastest to download)
    const buffer = await client.downloadMedia(msg.media, { thumb: 0, workers: 1 });
    const mime   = msg.media.photo ? 'image/jpeg' : (msg.media.document?.mimeType || 'image/jpeg');
    return await _bufToUri(buffer, mime);
  } catch {
    // thumb not available — fall back to full download (small images only)
    try {
      const buffer = await client.downloadMedia(msg.media, { workers: 1 });
      return await _bufToUri(buffer, 'image/jpeg');
    } catch {
      return null;
    }
  }
}
