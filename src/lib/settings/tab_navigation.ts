/** Header drags scroll only the header. They never activate a tab or bubble to page swipes. */
export function bindTabHeaderDrag(header: HTMLElement, remember: (left: number) => void): () => void {
    let startX = 0, startY = 0, startLeft = 0;
    let active = false;
    let axis: "x" | "y" | null = null;
    let suppressClickUntil = 0;
    const start = (event: TouchEvent) => {
        active = event.touches.length === 1;
        axis = null;
        if (!active) return;
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
        startLeft = header.scrollLeft;
        event.stopPropagation();
    };
    const move = (event: TouchEvent) => {
        if (!active || event.touches.length !== 1) return;
        const dx = event.touches[0].clientX - startX, dy = event.touches[0].clientY - startY;
        if (!axis && Math.max(Math.abs(dx), Math.abs(dy)) > 6) axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (axis !== "x") return;
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        header.scrollLeft = startLeft - dx;
        remember(header.scrollLeft);
    };
    const end = (event: TouchEvent) => {
        if (axis === "x") {
            suppressClickUntil = Date.now() + 500;
            if (event.cancelable) event.preventDefault();
            event.stopPropagation();
        }
        active = false;
        axis = null;
    };
    const click = (event: MouseEvent) => {
        if (Date.now() < suppressClickUntil) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    };
    const scroll = () => remember(header.scrollLeft);
    header.addEventListener("touchstart", start, { passive: true });
    header.addEventListener("touchmove", move, { passive: false });
    header.addEventListener("touchend", end, { passive: false });
    header.addEventListener("touchcancel", end, { passive: false });
    header.addEventListener("click", click, true);
    header.addEventListener("scroll", scroll, { passive: true });
    return () => {
        header.removeEventListener("touchstart", start);
        header.removeEventListener("touchmove", move);
        header.removeEventListener("touchend", end);
        header.removeEventListener("touchcancel", end);
        header.removeEventListener("click", click, true);
        header.removeEventListener("scroll", scroll);
    };
}

/** Reveal only after an explicit selection change; never scroll ancestor settings pages. */
export function revealSelectedTab(header: HTMLElement, tab: HTMLElement): void {
    const box = header.getBoundingClientRect(), target = tab.getBoundingClientRect();
    if (target.left < box.left) header.scrollLeft += target.left - box.left;
    else if (target.right > box.right) header.scrollLeft += target.right - box.right;
}
