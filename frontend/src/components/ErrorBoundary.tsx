import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Contain a crashing panel to its own box. Without this, one malformed API
 * body (see the NewsPanel incident) unmounts the entire terminal. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.name}]`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="panel">
          <div className="panel__head">
            <span className="panel__title">{this.props.name}</span>
          </div>
          <div className="err" style={{ margin: 10 }}>
            该面板出错（其余功能不受影响）· {this.state.error.message}
            <div>
              <button className="btn btn--mini" style={{ marginTop: 8 }} onClick={() => this.setState({ error: null })}>
                重试
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
