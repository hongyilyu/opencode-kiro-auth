// List models available to this Kiro account (never prints the token).
import { getValidAccessToken } from "../src/auth"
import { getProfileArn } from "../src/profile"
import { KIRO_MANAGEMENT_ENDPOINT, KIRO_CONTENT_TYPE, KIRO_MGMT_USER_AGENT, KIRO_ORIGIN } from "../src/constants"

const token = await getValidAccessToken()
const profileArn = await getProfileArn(token)
const res = await fetch(`${KIRO_MANAGEMENT_ENDPOINT}?origin=${KIRO_ORIGIN}`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": KIRO_CONTENT_TYPE,
    "x-amz-target": "AmazonCodeWhispererService.ListAvailableModels",
    "user-agent": KIRO_MGMT_USER_AGENT,
    "x-amz-user-agent": KIRO_MGMT_USER_AGENT,
  },
  body: JSON.stringify({ origin: KIRO_ORIGIN, profileArn }),
})
console.log("status:", res.status)
console.log(await res.text())
