import { createContext, useContext } from "react";

export const IDENTITY_CHANGE_KEY = "chat.identity-change";
export const identityNavigation = { replace: (path: string) => window.location.replace(path) };
export type Destination = "/" | "/admin/users" | "/login" | "/pending";
interface IdentityBoundaryActions {
  reconcile: () => Promise<boolean>;
  changeIdentity: (operation: () => Promise<void>, destination: Destination) => Promise<void>;
}
export const IdentityContext = createContext<IdentityBoundaryActions | null>(null);
export const useIdentityBoundary = () => useContext(IdentityContext);
