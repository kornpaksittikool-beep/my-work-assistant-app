export interface ScanRoot {
  path: string;
  accessible: boolean;
}

export interface ScanRootBrowseEntry {
  name: string;
  path: string;
  accessible: boolean;
}

export interface ScanRootBrowseResult {
  path: string | null;
  parent: string | null;
  entries: ScanRootBrowseEntry[];
}
