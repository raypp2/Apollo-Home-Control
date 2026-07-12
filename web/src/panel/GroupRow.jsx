// Apollo v2 dashboard -- one collapsed device GROUP row in the room command
// panel (see scenes/registry.js's DEVICE_GROUPS, e.g. the office's "Studio"
// group -- webcam key light + hair light). Renders like a switch DeviceRow
// (dot + title + On/Off) but tapping the body toggles every member together
// (commands.groupToggle); a '>' chevron -- same visual pattern as DeviceRow's
// color-swatch toggle -- expands the individual member rows inline beneath,
// each rendered by the normal DeviceRow so per-light control still works.

import { useState } from 'preact/hooks';
import { commands } from '../state/index.js';
import DeviceRow from './DeviceRow.jsx';

const ROW_HEIGHT = 46;
const FONT = "'Outfit', system-ui, sans-serif";
const ROW_BORDER = '1px solid rgba(234, 229, 239, 0.11)';
const ROW_BG = 'rgba(234, 229, 239, 0.03)';
const OFF_DOT = 'rgba(234, 229, 239, 0.18)';
const AMBER = 'var(--amber, #f2a65e)';

/**
 * @param {object} props
 * @param {{id:string,title:string}} props.group - a DEVICE_GROUPS entry
 * @param {Array<object>} props.entries - the group's member device entries,
 *   in display order
 */
function GroupRow({ group, entries }) {
  const [expanded, setExpanded] = useState(false);
  const anyOn = entries.some((entry) => commands.isOn(entry));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
        <div
          onClick={() => commands.groupToggle(entries)}
          style={{
            position: 'relative',
            flex: 1,
            minWidth: 0,
            height: ROW_HEIGHT,
            borderRadius: 'var(--r-row, 11px)',
            border: ROW_BORDER,
            background: ROW_BG,
            overflow: 'hidden',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <div
            style={{
              position: 'relative',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '0 12px',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                flexShrink: 0,
                background: anyOn ? AMBER : OFF_DOT,
                boxShadow: anyOn ? `0 0 5px 1px ${AMBER}` : 'none',
              }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
              <span
                style={{
                  fontFamily: FONT,
                  fontWeight: 500,
                  fontSize: 13.5,
                  color: 'var(--text, #eae5ef)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {group.title}
              </span>
              <span
                style={{
                  fontFamily: FONT,
                  fontWeight: 300,
                  fontSize: 10.5,
                  color: 'rgba(234, 229, 239, 0.4)',
                }}
              >
                {entries.length} lights
              </span>
            </div>
            <span
              style={{
                fontFamily: FONT,
                fontWeight: 600,
                fontSize: 12,
                flexShrink: 0,
                color: 'var(--text, #eae5ef)',
              }}
            >
              {anyOn ? 'On' : 'Off'}
            </span>
          </div>
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide Studio lights' : 'Show Studio lights'}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((open) => !open);
          }}
          style={{
            width: 32,
            height: ROW_HEIGHT,
            flexShrink: 0,
            borderRadius: 'var(--r-row, 11px)',
            border: ROW_BORDER,
            background: ROW_BG,
            color: 'var(--text-secondary, rgba(234, 229, 239, 0.55))',
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: 14,
            cursor: 'pointer',
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 150ms var(--ease-turn, ease)',
          }}
        >
          &rsaquo;
        </button>
      </div>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 10 }}>
          {entries.map((entry) => (
            <DeviceRow key={entry.stateTopic || entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

export default GroupRow;
