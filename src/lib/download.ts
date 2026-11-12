/** Hands a file to the browser's download: a link to an object address, clicked once, whose address is released a little later. */
export function saveBlob(blob: Blob, fileName: string): void {
  const address = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = address;
  link.download = fileName;
  link.rel = "noopener";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers start reading the object address after the click returns, so it is released later, not at once.
  setTimeout(() => URL.revokeObjectURL(address), 30_000);
}
