/**
 * The mockup's pill switch: a real `role="switch"`, not a styled checkbox.
 *
 * Lives here rather than in Settings because it is generic chrome — the label
 * is an `aria-label` because every use so far sits beside its own visible text.
 */

import type { ReactElement } from "react";

/** The mockup's pill switch, wired as a real `role="switch"` control. */
export default function Toggle({
    checked,
    label,
    disabled,
    onChange,
}: {
    checked: boolean;
    label: string;
    disabled?: boolean;
    onChange: (next: boolean) => void;
}): ReactElement {
    return (
        <button
            type="button"
            className={`toggle${checked ? " on" : ""}`}
            role="switch"
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            onClick={() => onChange(!checked)}
        />
    );
}
