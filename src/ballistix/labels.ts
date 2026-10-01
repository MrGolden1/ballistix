/**
 * Button labels as small key caps. PlayStation symbols get their familiar colours so they read like
 * the real buttons; everything else is a plain key cap.
 */
const PS_CLASS: Record<string, string> = { '✕': 'cross', '○': 'circle', '□': 'square', '△': 'triangle' };

export function kbd(label: string): string {
  if (!label) return '';
  const cls = PS_CLASS[label];
  return `<kbd${cls ? ` class="ps ${cls}"` : ''}>${label}</kbd>`;
}

/** Sets the text of an existing <kbd> and colours it if it is a PlayStation symbol; hides it when empty. */
export function setKeycap(el: HTMLElement, label: string): void {
  el.textContent = label;
  el.className = PS_CLASS[label] ? `ps ${PS_CLASS[label]}` : '';
  el.style.display = label ? '' : 'none';
}
