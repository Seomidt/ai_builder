if (!process.env.GITHUB_TOKEN) {
  console.warn("[github] GITHUB_TOKEN not set — GitHub tools will not function");
}

export const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
export const GITHUB_OWNER = process.env.GITHUB_OWNER ?? "";
export const GITHUB_REPO = process.env.GITHUB_REPO ?? "";
export const GITHUB_DEFAULT_BRANCH = process.env.GITHUB_DEFAULT_BRANCH ?? "main";

export function getGithubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function getAuthenticatedUser(): Promise<{ login: string } | null> {
  if (!GITHUB_TOKEN) return null;
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: getGithubHeaders(),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
