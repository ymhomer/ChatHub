import { filenameTimestamp } from '@/lib/txt';

const imageExtensions: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico', 'image/tiff': 'tiff',
};

export function nameClipboardImages(files: File[], date = new Date()) {
  const timestamp = filenameTimestamp(date) + '-' + String(date.getMilliseconds()).padStart(3, '0');
  return files.map((file, index) => {
    const mime = file.type.toLowerCase().split(';')[0];
    const original = /\.(png|jpe?g|webp|gif|avif|bmp|svg|ico|heic|heif|tiff?)$/i.exec(file.name)?.[1].toLowerCase();
    const hasImageType = mime.startsWith('image/');
    const needsType = !mime || mime === 'application/octet-stream';
    if (!hasImageType && !(needsType && original)) return file;
    const format = /^image\/([a-z0-9]+)$/.exec(mime)?.[1];
    const extension = imageExtensions[mime] ?? format ?? original ?? 'img';
    const suffix = files.length > 1 ? '-' + String(index + 1).padStart(2, '0') : '';
    const inferredMime = extension === 'svg' ? 'image/svg+xml' :
      /^(jpg|jpeg)$/.test(extension) ? 'image/jpeg' :
      extension === 'ico' ? 'image/x-icon' : `image/${extension}`;
    return new File([file], `${timestamp}${suffix}.${extension}`, {
      type: hasImageType ? file.type : inferredMime, lastModified: date.getTime(),
    });
  });
}
