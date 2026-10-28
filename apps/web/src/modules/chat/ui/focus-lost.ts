/** Nothing has the caret, or what had it was just hidden (the covered composer). */
export const focusIsLost = () => {
  const active = document.activeElement;
  return !active || active === document.body || active.closest("[hidden]") !== null;
};
