export function syncErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'Image upload failed. Check your connection and retry.';
}
export function pendingImageMessage(count: number, errors: string[], conflicts = 0) {
  const reason = errors.find(x => /reconnect.*drive|drive.*reconnect/i.test(x)) || errors[0] || 'Retry uploads now. Open Note on the device where these images were added if their files are missing here.';
  return `${count} image${count === 1 ? '' : 's'} pending · ${reason}${conflicts ? ` · ${conflicts} conflict ${conflicts === 1 ? 'copy' : 'copies'} also need${conflicts === 1 ? 's' : ''} syncing` : ''}`;
}
