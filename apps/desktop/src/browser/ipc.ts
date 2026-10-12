import { ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import {
  BROWSER_ACT,
  BROWSER_BEGIN,
  BROWSER_END,
  BROWSER_CANCEL,
  BROWSER_NAVIGATE,
  BROWSER_SAVE,
  BROWSER_ALLOW_SITE,
  BROWSER_ALLOWED_SITES,
  BROWSER_DRIVE,
  BROWSER_LIFECYCLE,
  BROWSER_OPEN_EXTERNAL,
  BROWSER_REVOKE_SITE,
  BROWSER_SITE_ALLOWED,
  BROWSER_SNAPSHOT,
  BROWSER_WAIT_FOR,
} from "@chat/desktop-rpc";
import { isSafeExternalUrl } from "../config.ts";
import type { attachBrowserGuests } from "./guests.ts";
import {
  decodeAct,
  decodeBegin,
  decodeCallId,
  decodeNavigate,
  decodeSave,
  decodeDrive,
  decodeLifecycle,
  decodeSite,
  decodeSiteCheck,
  decodeSiteGrant,
  decodeSnapshot,
  decodeWaitFor,
} from "./requests.ts";
import type { SiteGrants } from "./site-grants.ts";

type Guests = ReturnType<typeof attachBrowserGuests>;

/**
 * The page's browser bridge. Each lookup throws unless the request comes from
 * the configured server's main frame, the same check as every other channel.
 */
export function registerBrowserIpc(access: {
  guests(event: IpcMainInvokeEvent): Guests;
  grants(event: IpcMainInvokeEvent): { grants: SiteGrants; origin: string };
  page(event: IpcMainInvokeEvent): void;
}) {
  ipcMain.handle(BROWSER_BEGIN, (event, payload: unknown) => {
    const guests = access.guests(event);
    const { callId, conversationId, deadline } = decodeBegin(payload);
    return guests.begin(callId, conversationId, deadline);
  });
  ipcMain.handle(BROWSER_END, (event, payload: unknown) =>
    access.guests(event).end(decodeCallId(payload)),
  );
  ipcMain.handle(BROWSER_CANCEL, (event, payload: unknown) =>
    access.guests(event).cancel(decodeCallId(payload)),
  );
  ipcMain.handle(BROWSER_NAVIGATE, (event, payload: unknown) => {
    const guests = access.guests(event);
    const { webContentsId, target, callId } = decodeNavigate(payload);
    return guests.navigate(webContentsId, target, callId);
  });
  ipcMain.handle(BROWSER_LIFECYCLE, (event, payload: unknown) => {
    const guests = access.guests(event);
    const { webContentsId, state } = decodeLifecycle(payload);
    return guests.setLifecycle(webContentsId, state);
  });
  ipcMain.handle(BROWSER_SNAPSHOT, (event, payload: unknown) => {
    const guests = access.guests(event);
    const { webContentsId, screenshot, callId } = decodeSnapshot(payload);
    return guests.snapshot(webContentsId, { screenshot }, callId);
  });
  ipcMain.handle(BROWSER_WAIT_FOR, (event, payload: unknown) => {
    const guests = access.guests(event);
    const { webContentsId, condition, callId } = decodeWaitFor(payload);
    return guests.waitFor(webContentsId, condition, callId);
  });
  ipcMain.handle(BROWSER_ACT, (event, payload: unknown) => {
    const guests = access.guests(event);
    const { webContentsId, action, callId } = decodeAct(payload);
    return guests.act(webContentsId, action, callId);
  });
  ipcMain.handle(BROWSER_SAVE, (event, payload: unknown) => {
    const guests = access.guests(event);
    const { webContentsId, urls, callId } = decodeSave(payload);
    return guests.save(webContentsId, urls, callId);
  });
  ipcMain.handle(BROWSER_DRIVE, (event, payload: unknown) => {
    const guests = access.guests(event);
    const { webContentsId, driving, callId } = decodeDrive(payload);
    return guests.drive(webContentsId, driving, callId);
  });
  ipcMain.handle(BROWSER_SITE_ALLOWED, (event, payload: unknown) => {
    const { grants, origin } = access.grants(event);
    const { conversationId, url } = decodeSiteCheck(payload);
    return grants.allowed(origin, conversationId, url);
  });
  ipcMain.handle(BROWSER_ALLOW_SITE, (event, payload: unknown) => {
    const { grants, origin } = access.grants(event);
    const { conversationId, url, scope } = decodeSiteGrant(payload);
    return grants.allow(origin, conversationId, url, scope);
  });
  ipcMain.handle(BROWSER_ALLOWED_SITES, (event) => {
    const { grants, origin } = access.grants(event);
    return grants.always(origin);
  });
  ipcMain.handle(BROWSER_REVOKE_SITE, (event, site: unknown) => {
    const { grants, origin } = access.grants(event);
    return grants.revoke(origin, decodeSite(site));
  });
  ipcMain.handle(BROWSER_OPEN_EXTERNAL, async (event, url: unknown) => {
    access.page(event);
    if (typeof url !== "string" || !isSafeExternalUrl(url)) throw new Error("Not a web address.");
    await shell.openExternal(url);
  });
}
