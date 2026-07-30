/**
 * Unibase Pay — the browser authorization flow that mints the
 * `UNIBASE_PROXY_AUTH` JWT used by the AIP platform and every AIP SDK.
 */

import { request } from "../http.js";
import { CliError } from "../errors.js";

interface InitResponse {
  code?: string;
  auth_url?: string;
  authUrl?: string;
}

export interface AuthSession {
  code: string;
  authUrl: string;
}

/** Start an authorization session and return the URL the user must approve. */
export async function initAuth(payBase: string): Promise<AuthSession> {
  const response = await request<InitResponse>(payBase, "/v1/init", {
    method: "POST",
    // The service expects a bare JSON `true` body, matching the AIP SDKs.
    body: true,
    timeoutMs: 30_000,
  });

  const authUrl = response.auth_url ?? response.authUrl;
  if (!authUrl) {
    throw new CliError(`No authorization URL in the response from ${payBase}/v1/init`);
  }
  return { code: response.code ?? "", authUrl };
}
