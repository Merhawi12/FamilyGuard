import { Component } from 'react';

export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
          <div className="card max-w-md w-full text-center">
            <span className="text-4xl">⚠️</span>
            <h1 className="text-lg font-semibold text-gray-900 mt-4">Something went wrong</h1>
            <p className="text-sm text-gray-500 mt-2">
              An unexpected error occurred. Try reloading the page — if it keeps happening, please contact support.
            </p>
            <button onClick={() => window.location.reload()} className="btn-primary mt-5">
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
