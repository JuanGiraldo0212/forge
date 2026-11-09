/**
 * Checks shared by the main process and the renderer: does a repo's git remote live on the GitLab
 * instance forge opens merge requests on? Pure, no Node imports.
 */

/** forge's default gitlab.baseUrl, when the config leaves it out. */
export const DEFAULT_GITLAB_URL = 'https://gitlab.com';

export const hostOf = (url: string): string => {
  try {
    return new URL(url.trim()).hostname;
  } catch {
    return '';
  }
};

/** The warning to show when the remote's host isn't the GitLab instance; undefined when it matches or either is unknown. */
export const gitlabHostMismatch = (remoteHost: string, gitlabUrl: string): string | undefined => {
  const gitlabHost = hostOf(gitlabUrl || DEFAULT_GITLAB_URL);
  if (!remoteHost || !gitlabHost || remoteHost === gitlabHost) return undefined;
  return `The remote is on ${remoteHost}, but forge opens merge requests on ${gitlabHost} (GitLab URL). MRs will fail for this repo until that matches.`;
};
