import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 渲染期异常兜底：React 在未捕获异常时会卸载整棵树，页面变成纯白且无任何提示。
 * 这里保留错误信息并提供重新加载入口，避免用户只能关闭再打开面板。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('渲染异常:', error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    // 兜底界面用内联样式：两个入口页的样式表不共享 .btn 等类，
    // 且异常本身可能来自样式未就绪的早期阶段，自包含才能保证可见可点。
    return (
      <div role="alert" style={{ padding: '24px 20px', fontSize: 13, lineHeight: 1.6 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>页面渲染出错</h3>
        <p style={{ margin: '0 0 16px', opacity: 0.75, wordBreak: 'break-word' }}>
          {error.message || '未知错误'}
        </p>
        <button
          type="button"
          onClick={this.handleReload}
          style={{
            padding: '6px 14px',
            fontSize: 13,
            cursor: 'pointer',
            border: '1px solid currentColor',
            borderRadius: 6,
            background: 'transparent',
            color: 'inherit',
          }}
        >
          重新加载
        </button>
      </div>
    );
  }
}
