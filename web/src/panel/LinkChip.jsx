// Apollo v2 dashboard -- link-out chip (dashboard redesign, Living Room media
// links). Unlike DeviceRow/AccentRow these are NOT stateful devices: no
// status dot, no fill bar, no toggle. They're plain external anchors that
// open a media server's own web UI in a new tab. Deliberately styled to look
// like a small pill button, not a device row, so it reads as "leaves the
// app" rather than "controls something".

const FONT = "'Outfit', system-ui, sans-serif";

/** Plex chevron/stripe mark, amber (#e5a00d), monochrome. */
function PlexLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="0.5" y="0.5" width="15" height="15" rx="4" fill="#e5a00d" fillOpacity="0.16" />
      <rect x="0.5" y="0.5" width="15" height="15" rx="4" stroke="#e5a00d" strokeOpacity="0.5" />
      <path d="M6 3.6L10.6 8L6 12.4" stroke="#e5a00d" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Jellyfin rounded-blob mark, purple->blue gradient. */
function JellyfinLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="jellyfinGrad" x1="2" y1="2" x2="14" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#aa5cc3" />
          <stop offset="1" stopColor="#00a4dc" />
        </linearGradient>
      </defs>
      <path
        d="M8 2C10.8 6 12.5 8.6 12.5 10.4C12.5 12.6 10.5 14 8 14C5.5 14 3.5 12.6 3.5 10.4C3.5 8.6 5.2 6 8 2Z"
        fill="url(#jellyfinGrad)"
      />
      <ellipse cx="6.5" cy="9.2" rx="1" ry="1.4" fill="rgba(255,255,255,0.35)" />
    </svg>
  );
}

// Registry: link id (from config/rooms.json `links` array) -> display info.
// Unknown ids are skipped gracefully by the caller (RoomPanel).
const LINK_REGISTRY = {
  plex: {
    label: 'Plex',
    url: 'http://pi.local:32400/web',
    logo: PlexLogo,
  },
  jellyfin: {
    label: 'Jellyfin',
    url: 'http://pi.local:8096/web/#/home',
    logo: JellyfinLogo,
  },
};

/**
 * @param {object} props
 * @param {string} props.id - link id, looked up in LINK_REGISTRY
 */
function LinkChip({ id }) {
  const link = LINK_REGISTRY[id];
  if (!link) return null;
  const Logo = link.logo;

  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '7px 12px',
        borderRadius: 'var(--r-btn, 9px)',
        border: '1px solid var(--hairline, rgba(234, 229, 239, 0.1))',
        background: 'rgba(234, 229, 239, 0.03)',
        color: 'var(--text, #eae5ef)',
        fontFamily: FONT,
        fontWeight: 500,
        fontSize: 12,
        textDecoration: 'none',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        transition: 'background 120ms ease, border-color 120ms ease',
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = 'rgba(234, 229, 239, 0.07)';
        event.currentTarget.style.borderColor = 'rgba(234, 229, 239, 0.2)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'rgba(234, 229, 239, 0.03)';
        event.currentTarget.style.borderColor = 'var(--hairline, rgba(234, 229, 239, 0.1))';
      }}
    >
      <Logo />
      {link.label}
    </a>
  );
}

export { LINK_REGISTRY };
export default LinkChip;
