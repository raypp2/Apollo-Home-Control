// Apollo v2 dashboard -- generic full-panel drill-in overlay chrome. Built
// for the Accent drill-in (increment 3), reused as-is by AV/climate drill-ins
// in increment 4: a titled overlay covering the whole command panel, a back
// button, and labeled groups of segmented on/off buttons.

const FONT = "'Outfit', system-ui, sans-serif";

const OVERLAY_STYLE = {
  position: 'absolute',
  inset: 0,
  background: 'var(--bg-drill, #16131c)',
  display: 'flex',
  flexDirection: 'column',
  zIndex: 5,
};

/**
 * Full-panel overlay shell: header with a back button + title, a scrollable
 * body for the caller's content.
 * @param {object} props
 * @param {string} props.title
 * @param {() => void} props.onBack
 * @param {import('preact').ComponentChildren} props.children
 */
export function DrillInShell({ title, onBack, children }) {
  return (
    <div style={OVERLAY_STYLE}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '24px 26px 14px',
          flexShrink: 0,
          borderBottom: '1px solid var(--hairline, rgba(234, 229, 239, 0.1))',
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--accent, #a688e8)',
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 13.5,
            cursor: 'pointer',
            padding: '6px 10px 6px 0',
          }}
        >
          &lsaquo; back
        </button>
        <div style={{ fontFamily: FONT, fontWeight: 600, fontSize: 18 }}>{title}</div>
      </div>
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '18px 26px 26px',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A labeled group of segmented on/off buttons, e.g. "ADJ FIXTURE": [Ceiling]
 * [Webcam Back]. Each item drives its own toggle -- the group has no notion
 * of exclusivity.
 * @param {object} props
 * @param {string} props.label
 * @param {Array<{id:string, title:string, on:boolean, onToggle:() => void}>} props.items
 */
export function SegmentedGroup({ label, items }) {
  if (!items.length) return null;
  return (
    <div>
      <div
        style={{
          fontFamily: FONT,
          fontWeight: 500,
          fontSize: 11,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary, rgba(234, 229, 239, 0.32))',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={item.onToggle}
            style={{
              padding: '8px 14px',
              borderRadius: 'var(--r-row, 11px)',
              border: item.on
                ? '1px solid var(--amber, #f2a65e)'
                : '1px solid rgba(234, 229, 239, 0.11)',
              background: item.on ? 'rgba(242, 166, 94, 0.16)' : 'rgba(234, 229, 239, 0.03)',
              color: item.on
                ? 'var(--amber-text, #f2c79a)'
                : 'var(--text, #eae5ef)',
              fontFamily: FONT,
              fontWeight: 500,
              fontSize: 12.5,
              cursor: 'pointer',
            }}
          >
            {item.title}
          </button>
        ))}
      </div>
    </div>
  );
}
