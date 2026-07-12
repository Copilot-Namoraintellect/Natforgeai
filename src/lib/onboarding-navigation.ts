export function shouldScrollToTop(previousStep: number, nextStep: number): boolean {
  return previousStep !== nextStep;
}

export function scrollToTop(scroller: ((options?: ScrollToOptions) => void) | null | undefined): void {
  if (!scroller) return;
  scroller({ top: 0, behavior: "smooth" });
}
