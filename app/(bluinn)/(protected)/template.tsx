/**
 * Route transition for the admin panel.
 *
 * Next gives a template a fresh key on every navigation, so the CSS animation
 * on this wrapper replays each time a section changes — the sidebar stays put
 * while the content fades in. The animation is disabled for visitors who ask
 * for reduced motion, by the rule in globals.css.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
