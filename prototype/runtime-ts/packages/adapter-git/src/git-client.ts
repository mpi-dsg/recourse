export interface GitClient {
  revParse(ref: string): Promise<string | null>;
  updateRef(ref: string, sha: string, expectedCurrent?: string): Promise<void>;
  deleteRef(ref: string): Promise<void>;
  commitObjectSize(sha: string): Promise<number>;
}

export class GitClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitClientError";
  }
}

export const GIT_REF_RE = /^refs\/[A-Za-z0-9_./-]+$/;
export const GIT_SHA_RE = /^[0-9a-f]{40}$/;

export function assertGitRef(ref: string): void {
  if (!GIT_REF_RE.test(ref)) throw new GitClientError(`invalid git ref: ${ref}`);
}

export function assertGitSha(sha: string): void {
  if (!GIT_SHA_RE.test(sha)) throw new GitClientError(`invalid git sha: ${sha}`);
}
