import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  GitClientError,
  assertGitRef,
  assertGitSha,
  type GitClient,
} from "./git-client.ts";

const execFile = promisify(execFileCallback);

export class LocalBareGitClient implements GitClient {
  constructor(private readonly repoPath: string) {}

  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFile("git", ["--git-dir", this.repoPath, ...args], {
        encoding: "utf8",
      });
      return stdout.trimEnd();
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? String(error);
      throw new GitClientError(`git ${args.join(" ")} failed: ${stderr}`);
    }
  }

  async revParse(ref: string): Promise<string | null> {
    assertGitRef(ref);
    try {
      return await this.git(["rev-parse", "--verify", `${ref}^{commit}`]);
    } catch {
      return null;
    }
  }

  async updateRef(ref: string, sha: string, expectedCurrent?: string): Promise<void> {
    assertGitRef(ref);
    assertGitSha(sha);
    const args = ["update-ref", ref, sha];
    if (expectedCurrent !== undefined) {
      assertGitSha(expectedCurrent);
      args.push(expectedCurrent);
    }
    await this.git(args);
  }

  async deleteRef(ref: string): Promise<void> {
    assertGitRef(ref);
    await this.git(["update-ref", "-d", ref]);
  }

  async commitObjectSize(sha: string): Promise<number> {
    assertGitSha(sha);
    const out = await this.git(["cat-file", "-s", sha]);
    return Number.parseInt(out, 10);
  }
}
