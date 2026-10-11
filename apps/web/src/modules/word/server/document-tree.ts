// Loaded by the Word worker under plain Node in development: relative imports only.

/**
 * A live document's tree as ProseMirror writes it to JSON. The worker reads
 * and writes this plain shape, never the schema: the app checks every tree
 * it builds from a file against the schema before storing it.
 */
export interface TreeMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface TreeNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TreeNode[];
  marks?: TreeMark[];
  text?: string;
}

/** One open comment thread, as a Word comment: its first comment's author, its replies in the text. */
export interface WordThread {
  id: string;
  author: string;
  /** ISO time of the thread's first comment. */
  date: string;
  text: string;
}

/** What a document's Word file is built from. */
export interface DocumentForWord {
  title: string;
  tree: TreeNode;
  /** Image bytes by the `src` the tree gives them; an image missing here is left out. */
  images: Record<string, Uint8Array>;
  threads: WordThread[];
}

/** The bounds a document holds, passed in so the worker refuses a file past them as it reads. */
export interface DocumentBounds {
  blocks: number;
  chars: number;
  imageBytes: number;
  comments: number;
  comment: number;
  quote: number;
}

/** A comment read from a Word file, by the thread it belongs to. */
export interface ImportedComment {
  author: string;
  text: string;
}
export interface ImportedThread {
  /** The placeholder its text's comment marks carry. */
  ref: string;
  comments: ImportedComment[];
  quote: string;
  resolved: boolean;
}

/** A Word file read as a document: images by index (`image:N` sources), threads by `ref`. */
export interface WordAsDocument {
  title: string | null;
  tree: TreeNode;
  images: Array<{ bytes: Uint8Array; mediaType: string }>;
  threads: ImportedThread[];
  /** What the file held that a document cannot, one phrase each. */
  dropped: string[];
}

/** Where an imported image's bytes sit until the app stores them. */
export const IMAGE_REF = "image:";
