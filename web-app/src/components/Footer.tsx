import { Link } from 'react-router-dom';

const footerGroups = [
  {
    title: 'Product',
    links: [
      { label: 'Features', to: '/#features' },
      { label: 'How it works', to: '/#how-it-works' },
      { label: 'Pricing', to: '/pricing' },
      { label: 'Download', to: '/download' },
    ],
  },
  {
    title: 'Account',
    links: [
      { label: 'Sign in', to: '/login' },
      { label: 'Create account', to: '/register' },
      { label: 'FAQ', to: '/#faq' },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div className="footer-brand">
          <Link to="/" className="footer-logo" aria-label="Cueviq home">
            <img className="theme-logo theme-logo-dark" src="/cueviq_logo_dark.svg" alt="Cueviq" />
            <img className="theme-logo theme-logo-light" src="/cueviq_logo_light.svg" alt="Cueviq" />
          </Link>
          <p>The smart cue at the right moment—clear, real-time guidance for high-pressure interviews.</p>
          <div className="footer-availability"><span /> Available for Windows &amp; macOS</div>
        </div>

        {footerGroups.map((group) => (
          <div className="footer-group" key={group.title}>
            <h2>{group.title}</h2>
            {group.links.map((link) => <Link to={link.to} key={link.to}>{link.label}</Link>)}
          </div>
        ))}

        <div className="footer-group footer-contact">
          <h2>Need a hand?</h2>
          <p>Questions about setup, payments, or your account?</p>
          <a href="mailto:upnodsupport@gmail.com">upnodsupport@gmail.com</a>
        </div>
      </div>

      <div className="container footer-bottom">
        <p>&copy; {new Date().getFullYear()} Cueviq. All rights reserved.</p>
        <p>Designed for calmer, more confident conversations.</p>
      </div>
    </footer>
  );
}
