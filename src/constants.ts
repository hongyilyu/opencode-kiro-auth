import { platform } from "node:os"

export const PROVIDER_ID = "kiro"

export const API_PROVIDER_ID = "kiro-api"

/** Default model when a request omits one. Kiro rejects an empty modelId. */
export const DEFAULT_MODEL = "claude-sonnet-4.6"

/** Refresh the access token this long before it expires. */
export const EXPIRY_SKEW_MS = 5 * 60 * 1000

/** Kiro CodeWhisperer endpoints + awsJson1.0 wire facts (verified against kiro-cli). */
export const KIRO_ENDPOINT = "https://runtime.us-east-1.kiro.dev/"
/** Endpoint kiro-cli uses for the InvokeMCP operation (built-in web_search). */
export const KIRO_MCP_ENDPOINT = "https://q.us-east-1.amazonaws.com/"
/** Kiro's web-search backend rejects queries longer than this many characters. */
export const WEB_SEARCH_QUERY_MAX = 200
export const KIRO_MANAGEMENT_ENDPOINT = "https://management.us-east-1.kiro.dev/"
export const KIRO_MANAGEMENT_ENDPOINTS = [
  KIRO_MANAGEMENT_ENDPOINT,
  "https://management.eu-central-1.kiro.dev/",
]
export const KIRO_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse"
export const KIRO_INVOKE_MCP_TARGET = "AmazonCodeWhispererStreamingService.InvokeMCP"
export const KIRO_LIST_PROFILES_TARGET = "AmazonCodeWhispererService.ListAvailableProfiles"
export const KIRO_GET_PROFILE_TARGET = "AmazonCodeWhispererService.GetProfile"
export const KIRO_CONTENT_TYPE = "application/x-amz-json-1.0"
export const KIRO_ORIGIN = "KIRO_CLI"

/**
 * profileArn placeholder kiro-cli sends for accounts without a profile (Builder ID).
 * Accounts that have one resolve their real ARN at runtime (profile.ts).
 */
export const KIRO_PROFILE_ARN_PLACEHOLDER = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"

/** User-Agent matching kiro-cli. Bump KIRO_CLI_VERSION to match `kiro-cli --version`. */
const KIRO_CLI_VERSION = "2.18.0"
const KIRO_SDK_API_VERSION = "0.1.17975"
const KIRO_OS = platform() === "win32" ? "windows" : platform() === "darwin" ? "macos" : "linux"
const ua = (api: string, metric: string) =>
  `aws-sdk-rust/1.3.15 ua/2.1 api/${api}/${KIRO_SDK_API_VERSION} os/${KIRO_OS} lang/rust/1.92.0 ${metric} app/AmazonQ-For-CLI`
export const KIRO_USER_AGENT = ua("codewhispererstreaming", `md/appVersion-${KIRO_CLI_VERSION}`)
export const KIRO_X_AMZ_USER_AGENT = ua("codewhispererstreaming", "m/F")
export const KIRO_MGMT_USER_AGENT = ua("codewhispererruntime", `md/appVersion-${KIRO_CLI_VERSION}`)
