# DoniaLink POS Offline (Odoo 18 module)

Lets the Odoo 18 Point of Sale **open without internet**, sell, and send the orders when the
server answers again. Works in the DoniaLink POS app (both engines) and in any modern browser.

## Install

1. Copy the `donialink_pos_offline` folder into a folder on the server's `addons_path`.
2. Restart Odoo, then **Apps → Update Apps List**, search "DoniaLink POS Offline", **Activate**.
3. **Point of Sale → Configuration → Settings → PoS Interface → Offline Mode** (on by default,
   per point of sale). Turning it off removes the saved page and data from the devices at their
   next start; orders are never touched.
4. Close and open each POS once **while online**. That start saves the page, its files and the
   POS data on the device. From then on the POS opens offline too.

**Needs HTTPS** (a domain with a certificate in front of Odoo, e.g. nginx + Let's Encrypt).
Browsers only allow the offline page cache (service worker) on secure sites. Over plain
`http://IP:8069` the panel shows "Open without internet: Needs HTTPS".

## What it does

| Part | File | Job |
|---|---|---|
| Service worker | `static/sw/sw.js`, served at `/pos/donialink_sw.js` | Keeps `/pos/ui` (one copy per POS config) and the JS/CSS bundles, translations, fonts and images. Network first for the page, saved copy when offline. |
| POS data | `static/src/offline_data.js` | Saves the `pos.session/load_data` answer in IndexedDB at every online start; uses it when the server can't be reached. |
| Status and sync | `static/src/offline_monitor.js` | Checks the server every 60 s (10 s while offline), switches the POS to offline mode, sends waiting orders when it answers again. Badge + "Offline & sync" panel (Sync now, Refresh data). Blocks closing the register without internet or with unsent orders. |
| Order safe | `static/src/order_safe.js` | Paid orders go to disk the moment they are paid (strict writes), plus a second copy in its own database, removed only once the server has the order. |
| Setting | `models/`, `views/` | `pos.config.dl_offline_mode` (Offline Mode). Only controls opening offline; order safety and the closing check are always on. |

Orders themselves are kept by Odoo: paid orders that aren't on the server yet stay in the
device's IndexedDB and are sent at the next start or when back online (`isUnsyncedPaid`).

The app's ⚙ menu → **Offline & sync** opens the panel (events `donialink:open`, `donialink:sync`,
`donialink:refresh` on `window`).

## Offline: what works and what doesn't

Works: selling, cash payments, receipts (printed by the app over USB / LAN), discounts,
pricelists and customers that were loaded.

Doesn't work until back online: card terminals, invoices, opening/closing the session,
new products or price changes made in the back office (press **Refresh data** when online),
anything that needs the server to answer (loyalty checks, kitchen
printers through Odoo).

## Order safety

- **Power cut / app killed:** Odoo normally saves orders on the device 200 ms after a change,
  with relaxed writes (may still be in memory when the power goes). The module writes a paid
  order at once with strict writes (on disk before the write counts as done) and keeps a
  second copy in its own database (`donialink_pos_orders`).
- **Nothing deletes an order:** a copy is removed only when the order has a server id or the
  server answered `sync_from_ui` for it. If Odoo's own storage lost an order, the copy is sent
  at the next sync. Sending a copy twice is harmless: the server finds orders by uuid and
  ignores ones it already has (no duplicates).
- **Closing the register** (menu and the closing popup's button) needs the server to answer
  and every order to be on the server. Otherwise it says why and doesn't close.
- Unsent orders live **only on that device** until they are sent. Clearing the app's data or
  uninstalling the app before they are sent loses them.
- Closing a session from the **back office** can't be blocked from a device. If a device
  still has orders waiting, Odoo puts them in a rescue session when they arrive (not lost).
- An order the server refuses (e.g. a validation error) stays on the device and keeps the
  register from closing; the panel shows the server's message.

## Test checklist

1. Online: open the POS. ⚙ → Offline & sync shows "Open without internet: Ready".
2. Switch the device to airplane mode, close the app, open it again: the POS opens, badge "Offline".
3. Make two cash sales, print receipts. Badge "Offline · 2 orders waiting".
4. Back online: within ~10 s the badge shows Syncing… then disappears; the orders are in the back office.
5. Server down but Wi-Fi up (stop Odoo): the POS switches to offline mode after two failed checks.
6. Change a price in the back office, press **Refresh data**: the new price shows.
7. Offline: make a sale, then pull the power / force-stop the app right after payment. Start
   again: the order is still waiting, and is sent when back online.
8. Offline: open the menu → Close Register: refused with "Closing needs internet".
9. Settings → Offline Mode off, reopen the POS online, then go offline and restart: the POS
   doesn't open offline any more (panel: "Off (POS setting)").
