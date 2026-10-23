'use strict';
/* Donation link — the developer's PayPal.me page. The URL is hard-coded here
   (the same fixed-target doctrine as the icon CDN and the log folder), so no
   renderer ever steers shell.openExternal somewhere else: the bridge only
   says "open the donate page", never "open this URL". */
const { shell } = require('electron');

const DONATE_URL = 'https://www.paypal.com/paypalme/kurtishight';

/** Open the donate page in the user's default browser. Never throws. */
async function openDonate() {
  try {
    const err = await shell.openExternal(DONATE_URL);
    return err ? { ok: false, error: String(err) } : { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { DONATE_URL, openDonate };
