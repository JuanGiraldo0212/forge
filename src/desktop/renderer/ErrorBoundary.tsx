import { Component, type ReactNode } from 'react';

/** Shows what broke instead of a blank window. Agents in the main process keep running. */
export class ErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly error: Error | undefined }> {
  override state = { error: undefined as Error | undefined };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="welcome">
        <h1>Something went wrong in the window</h1>
        <p className="muted">Running agents are not affected; they run in the main process.</p>
        <pre className="diff" style={{ padding: 12 }}>
          {this.state.error.message}
        </pre>
        <button className="btn btn-primary" onClick={() => this.setState({ error: undefined })}>
          Try again
        </button>
      </div>
    );
  }
}
