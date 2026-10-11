/** Pure helpers for project folders: finding a folder by name or id, and printing the folder tree. */

export interface FolderRow {
  _id: string;
  name: string;
  parentId?: string | null;
}

export interface FolderProjectRow {
  key: string;
  name: string;
  folderId?: string | null;
}

export type FolderLookup<T> = { kind: "one"; folder: T } | { kind: "none" } | { kind: "many"; matches: T[] };

/** An id match wins; otherwise a case-insensitive name match. Several name matches are ambiguous. */
export function findFolder<T extends FolderRow>(folders: readonly T[], ref: string): FolderLookup<T> {
  const byId = folders.find((folder) => folder._id === ref);
  if (byId) return { kind: "one", folder: byId };
  const wanted = ref.trim().toLowerCase();
  const named = folders.filter((folder) => folder.name.trim().toLowerCase() === wanted);
  if (named.length === 0) return { kind: "none" };
  if (named.length === 1) return { kind: "one", folder: named[0]! };
  return { kind: "many", matches: named };
}

/**
 * Folders as an indented tree: each folder, its subfolders, then its projects.
 * Projects that are not in any folder are listed last under "Top level".
 */
export function formatFolderTree(folders: readonly FolderRow[], projects: readonly FolderProjectRow[]): string {
  const lines: string[] = [];
  const childrenOf = (parentId: string | undefined) => folders.filter((folder) => (folder.parentId ?? undefined) === parentId);
  const walk = (parentId: string | undefined, depth: number) => {
    const pad = "  ".repeat(depth);
    for (const folder of childrenOf(parentId)) {
      lines.push(`${pad}${folder.name}`);
      walk(folder._id, depth + 1);
      for (const project of projects.filter((row) => row.folderId === folder._id)) lines.push(`${pad}  ${project.key}  ${project.name}`);
    }
  };
  walk(undefined, 0);
  const unfiled = projects.filter((project) => !folders.some((folder) => folder._id === project.folderId));
  if (unfiled.length) {
    lines.push("Top level");
    for (const project of unfiled) lines.push(`  ${project.key}  ${project.name}`);
  }
  return lines.length ? lines.join("\n") : "(no folders or projects)";
}
