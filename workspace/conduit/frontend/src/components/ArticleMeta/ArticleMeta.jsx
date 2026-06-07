import { Link } from "react-router-dom";
import dateFormatter from "../../helpers/dateFormatter";
import Avatar from "../Avatar";

function ArticleMeta({ author, children, createdAt, readingTime, readingCount }) {
  const { bio, followersCount, following, image, username } = author || {};

  return (
    <div className="article-meta">
      <Link
        state={{ bio, followersCount, following, image }}
        to={`/profile/${username}`}
      >
        <Avatar alt={username} src={image} />
      </Link>
      <div className="info">
        <Link
          className="author"
          state={{ bio, followersCount, following, image }}
          to={`/profile/${username}`}
        >
          {username}
        </Link>
        <span className="date">
          {dateFormatter(createdAt)}
          {readingCount != null && ` · ${readingCount} 次阅读`}
          {readingTime && ` · ${readingTime} 分钟阅读`}
        </span>
      </div>
      {children}
    </div>
  );
}

export default ArticleMeta;