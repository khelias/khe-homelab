// Entry point. Workers treat every named export of the main module as an
// entrypoint, so the logic lives in fallback.mjs.
import { handle } from "./fallback.mjs";

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
