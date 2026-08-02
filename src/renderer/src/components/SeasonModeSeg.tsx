import type { PlayMode } from "@shared/types.js";
import type { ReactElement } from "react";

/**
 * The three-way mode control on one season row: inherit, shuffle, in order.
 *
 * A component rather than three near-identical inline buttons — they differed
 * only in which value they carried, and the copies were long enough that the
 * *inherit* one's label (which has to name the show's current mode) was easy to
 * miss. `null` means inherit, which is also how the absence of a row in
 * `channel_show_season_modes` is read.
 */
export default function SeasonModeSeg({
    label,
    override,
    showMode,
    disabled,
    onPick,
}: {
    label: string;
    override: PlayMode | null;
    showMode: PlayMode;
    disabled: boolean;
    onPick(mode: PlayMode | null): void;
}): ReactElement {
    const options: Array<{ value: PlayMode | null; text: string }> = [
        {
            value: null,
            text: `Use show (${showMode === "sequential" ? "In order" : "Shuffle"})`,
        },
        { value: "shuffle", text: "Shuffle" },
        { value: "sequential", text: "In order" },
    ];
    return (
        <fieldset className="seg season-mode" aria-label={label}>
            {options.map((option) => {
                const on = override === option.value;
                return (
                    <button
                        key={option.value ?? "inherit"}
                        type="button"
                        className={on ? "on" : undefined}
                        aria-pressed={on}
                        disabled={disabled}
                        onClick={() => onPick(option.value)}
                    >
                        {option.text}
                    </button>
                );
            })}
        </fieldset>
    );
}
