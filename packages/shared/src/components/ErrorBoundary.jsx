import { Component } from 'react';
import Icon from './Icon.jsx';

export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-dvh flex items-center justify-center bg-gray-50 px-4 py-8">
        <div className="card max-w-md w-full text-center">
          <span className="inline-flex w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 items-center justify-center">
            <Icon name="warning" size={26} />
          </span>
          <h1 className="text-lg font-semibold text-gray-900 mt-4">Something went wrong</h1>
          <p className="text-sm text-gray-500 mt-2">
            An unexpected error occurred. Try reloading the page — if it keeps happening, please contact support.
          </p>
          <button onClick={() => window.location.reload()} className="btn-primary btn-block mt-5">
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
