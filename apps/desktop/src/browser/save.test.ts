import { describe, expect, it } from "vitest";
import { fileNameFor, saveFiles } from "./save.ts";

describe("saving files from a page", () => {
  it("names a file by its address, typed by what the server sent", () => {
    expect(fileNameFor("https://a.test/img/Alan%20Turing.jpg?w=200", "image/jpeg", 0)).toBe(
      "Alan Turing.jpg",
    );
    expect(fileNameFor("https://a.test/i/0dfaf23551c399c6", "image/png; q=1", 0)).toBe(
      "0dfaf23551c399c6.png",
    );
    expect(fileNameFor("https://a.test/", null, 2)).toBe("file-3");
    expect(fileNameFor("https://a.test/..%2F..%2Fetc%2Fpasswd", null, 0)).not.toContain("/");
  });

  it("saves each address, a few at a time, and says why one could not be saved", async () => {
    const landed: string[] = [];
    let open = 0;
    let most = 0;
    const outcomes = await saveFiles(
      ["https://a.test/1.png", "https://a.test/missing.png", "https://a.test/2.png"],
      async (url) => {
        open++;
        most = Math.max(most, open);
        await Promise.resolve();
        open--;
        return url.includes("missing")
          ? new Response(null, { status: 404 })
          : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      },
      async (name) => {
        landed.push(name);
        return `/work/${name}`;
      },
    );
    expect(outcomes).toEqual([
      { url: "https://a.test/1.png", path: "/work/1.png" },
      { url: "https://a.test/missing.png", error: "The site answered 404." },
      { url: "https://a.test/2.png", path: "/work/2.png" },
    ]);
    expect(landed).toEqual(["1.png", "2.png"]);
    expect(most).toBeLessThanOrEqual(4);
  });
});
