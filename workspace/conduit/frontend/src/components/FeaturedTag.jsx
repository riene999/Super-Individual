import React from 'react';

const FeaturedTag = ({ children, className = '', ...restProps }) => {
  return (
    <div
      className={`relative inline-flex items-center px-3 py-1.5 rounded-full bg-slate-50 text-slate-800 text-sm font-medium border border-slate-200 ${className}`}
      {...restProps}
    >
      {/* 左上角外侧高亮视觉标识 完全位于容器外部 不会遮挡内部文字内容 */}
      <span className="absolute -top-2.5 -left-2.5 w-5 h-5 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full shadow-lg flex items-center justify-center z-10">
        <span className="w-2 h-2 bg-white rounded-full opacity-90"></span>
      </span>
      {children}
    </div>
  );
};

export default FeaturedTag;