/**
 * The Settings rail's scroll spy.
 *
 * Its own module because it is self-contained and because the reasoning below
 * is the whole reason the rail works — it survives better next to the code it
 * explains than buried a third of the way down a screen component.
 */

import { type RefObject, useEffect, useState } from "react";

/** How far below the top of the scroller a section counts as the one being read. */
const TUNE_LINE_PX = 96;

/**
 * Which stop the reader is on.
 *
 * Scroll-position based rather than an `IntersectionObserver`, because of the
 * bottom of the page: the last section is shorter than the window, so it never
 * becomes the top-most intersecting element and the dial stays stuck on 03 no
 * matter how far you scroll. Reaching the end of the scroll *is* the signal
 * that you have arrived at the last stop, and only a scroll position can say
 * that.
 */
export function useTunedSection(
    bodyRef: RefObject<HTMLDivElement | null>,
    sections: ReadonlyArray<{ id: string }>,
): string {
    const [tuned, setTuned] = useState<string>(sections[0]?.id ?? "");

    useEffect(() => {
        const scroller = bodyRef.current?.closest(".app-scroll");
        if (!(scroller instanceof HTMLElement)) return;

        function read(): void {
            if (!(scroller instanceof HTMLElement)) return;
            const stops = sections
                .map((section) => document.getElementById(section.id))
                .filter((node): node is HTMLElement => node != null);
            if (stops.length === 0) return;

            // Bottomed out: the last stop is the one being looked at, whatever the
            // section tops say. Guarded on the page actually scrolling — on a window
            // tall enough to hold every section, "the end of the scroll" is also the
            // top of the page, and the dial would open on 04 and stay there.
            const scrollable =
                scroller.scrollHeight > scroller.clientHeight + 2;
            if (
                scrollable &&
                scroller.scrollTop + scroller.clientHeight >=
                    scroller.scrollHeight - 2
            ) {
                setTuned(stops[stops.length - 1].id);
                return;
            }

            const line = scroller.getBoundingClientRect().top + TUNE_LINE_PX;
            let next = stops[0].id;
            for (const stop of stops) {
                if (stop.getBoundingClientRect().top <= line) next = stop.id;
            }
            setTuned(next);
        }

        read();
        scroller.addEventListener("scroll", read, { passive: true });
        window.addEventListener("resize", read);
        return () => {
            scroller.removeEventListener("scroll", read);
            window.removeEventListener("resize", read);
        };
    }, [bodyRef, sections]);

    return tuned;
}
