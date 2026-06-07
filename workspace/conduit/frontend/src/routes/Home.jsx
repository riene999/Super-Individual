import { Outlet, Link } from "react-router-dom";
import { useEffect, useState } from "react";
import BannerContainer from "../components/BannerContainer";
import ContainerRow from "../components/ContainerRow";
import FeedToggler from "../components/FeedToggler";
import { useAuth } from "../context/AuthContext";
import FeedProvider from "../context/FeedContext";
import FeaturedTag from "../components/FeaturedTag";
import agent from "../agent";

function Home() {
  const { isAuth } = useAuth();
  const [tags, setTags] = useState([]);

  useEffect(() => {
    agent.Tags.getAll().then(res => setTags(res.tags || []));
  }, []);

  return (
    <div className="home-page">
      {!isAuth && (
        <BannerContainer>
          <h1 className="logo-font">conduit</h1>
          <p>A place to share your knowledge.</p>
        </BannerContainer>
      )}
      <ContainerRow type="page">
        <FeedProvider>
          <div className="col-md-9">
            <FeedToggler />
            <Outlet />
          </div>

          <div className="col-md-3">
            <div className="sidebar">
              <p>Popular Tags</p>
              <div className="tag-list">
                {tags.map((tag, index) => {
                  if (index < 5) {
                    return <FeaturedTag key={tag} tag={tag} />;
                  }
                  return (
                    <Link
                      key={tag}
                      to={`/tags/${tag}`}
                      className="tag tag-pill tag-outline"
                    >
                      {tag}
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        </FeedProvider>
      </ContainerRow>
    </div>
  );
}

export default Home;