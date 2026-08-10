import { uploads } from './endpoints.js';

/**
 * Uploads an image straight to Cloud Storage and returns the URL to persist.
 *
 * The bytes never touch the API — it only signs the request. The PUT itself
 * must carry no Authorization header (the signature covers the headers, and an
 * extra one makes the bucket reject it), which is why plain `fetch` is used rather
 * than the configured axios client.
 *
 * @param {File} file
 * @param {{ childId: string }} target
 * @returns {Promise<string>} the public URL of the stored image
 */
export const uploadChildAvatar = async (file, { childId }) => {
  const { data } = await uploads.childAvatar({
    childId,
    contentType: file.type,
    contentLength: file.size,
  });

  const response = await fetch(data.uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
  });

  if (!response.ok) {
    throw new Error(`Upload failed (${response.status}). The link may have expired — please try again.`);
  }

  return data.url;
};
