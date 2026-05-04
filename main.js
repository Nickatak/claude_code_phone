import { ManagedQuery } from "./managed_query.js";

const message =
  "Hello Claude, lookup the weather today in 91773 and tell me what temperature it is.";

console.log("[Thinking...]");
const t0 = Date.now();

const mq = new ManagedQuery(message);

mq.callback_fin(() => {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[${mq.status} in ${elapsed}s]\n`);
  if (mq.status === "success") {
    console.log(mq.text);
  } else if (mq.status === "error") {
    console.log(`Error: ${mq.error}`);
  }
  // stopped: nothing else to print
});
