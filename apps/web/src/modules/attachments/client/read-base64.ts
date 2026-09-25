/** A picked file as base64, without the `data:` prefix, for JSON request bodies. */
export const readBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return reject(new Error("Could not read that file."));
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
