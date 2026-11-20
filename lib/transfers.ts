export const PART_BYTES = 8 * 1024 * 1024;
export const MAX_TRANSFER_FILE = 1024 * 1024 * 1024;
export const MAX_TRANSFER_TOTAL = 2 * MAX_TRANSFER_FILE;
export const TRANSFER_MINUTES = [15, 60, 1440];

export type TransferFile = { id: string; name: string; bytes: number; status: 'uploading' | 'ready'; fingerprint: string };
export type TransferFolder = { id: string; name: string; expires: number | null; token: string | null; files: TransferFile[] };
