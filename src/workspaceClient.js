import * as sessionApi from "./sessionApi.js";
import { sendSessionChat, retryLiveCapture } from "./liveApi.js";
import { updateWorkspacePreferences, downloadSessionExport } from "./workspaceApi.js";

export const liveWorkspaceClient = Object.freeze({
  ...sessionApi, sendSessionChat, retryLiveCapture, updateWorkspacePreferences, downloadSessionExport, example: false,
});
