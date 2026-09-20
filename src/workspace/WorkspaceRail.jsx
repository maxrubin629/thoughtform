import { useState } from "react";
import {
  IconAffiliate, IconClock, IconFocusCentered, IconMessageCircle,
  IconSearch, IconSettings, IconStar,
} from "@tabler/icons-react";

const DRAWER_TOOLS = {
  maps: { label: "Maps", icon: IconAffiliate, className: "session-brand-button" },
  conversation: { label: "Conversation", icon: IconMessageCircle },
  search: { label: "Search", icon: IconSearch },
  activity: { label: "Activity", icon: IconClock },
  settings: { label: "Settings", icon: IconSettings },
  profile: { label: "Account", content: "MR", className: "avatar-button" },
};

function RailButton({ label, children, active = false, pressed, expanded, onClick, testId, className = "" }) {
  return <div className={`session-rail-item ${active ? "is-current" : ""}`}>
    <button type="button" className={`icon-button ${active ? "is-active" : ""} ${className}`}
      aria-label={label} aria-pressed={pressed} aria-expanded={expanded}
      onClick={onClick} data-testid={testId}>{children}</button>
    <span className="session-rail-tooltip" aria-hidden="true">{label}</span>
  </div>;
}

function DrawerTools({ names, drawerOpen, drawerTab, openDrawer }) {
  return names.map((name) => {
    const { label, icon: Icon, content, className } = DRAWER_TOOLS[name];
    const active = drawerOpen && drawerTab === name;
    return <RailButton key={name} label={label} active={active} expanded={active}
      onClick={() => openDrawer(name)} className={className} testId={`${name}-tool`}>
      {Icon ? <Icon /> : content}
    </RailButton>;
  });
}

/** The rail only navigates drawers, changes focus, and owns its local favorite toggle. */
export function WorkspaceRail({ drawerOpen, drawerTab, openDrawer, focusId, toggleFocus }) {
  const [favorite, setFavorite] = useState(true);
  const navigation = { drawerOpen, drawerTab, openDrawer };
  return <nav className="side-rail session-side-rail" aria-label="Workspace and session tools">
    <div className="session-rail-home"><DrawerTools names={["maps"]} {...navigation} /></div>
    <div className="session-rail-group" role="group" aria-label="Your workspace">
      <DrawerTools names={["conversation", "search", "activity"]} {...navigation} />
    </div>
    <div className="session-rail-divider" />
    <div className="session-rail-group" role="group" aria-label="This map">
      <RailButton label={focusId ? "Show full map" : "Focus selected branch"} active={Boolean(focusId)}
        pressed={Boolean(focusId)} onClick={toggleFocus} testId="focus-tool"><IconFocusCentered /></RailButton>
      <RailButton label={favorite ? "Remove favorite" : "Add favorite"} pressed={favorite}
        className="session-favorite-button" onClick={() => setFavorite((value) => !value)} testId="favorite-tool"><IconStar /></RailButton>
    </div>
    <div className="session-rail-group session-rail-footer" role="group" aria-label="Account and preferences">
      <DrawerTools names={["settings", "profile"]} {...navigation} />
    </div>
  </nav>;
}
