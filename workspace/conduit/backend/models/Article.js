"use strict";
const { Model } = require("sequelize");
module.exports = (sequelize, DataTypes) => {
  class Article extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate({ User, Tag, Comment }) {
      // define association here

      // Users
      this.belongsTo(User, { foreignKey: "userId", as: "author" });

      // Comments
      this.hasMany(Comment, { foreignKey: "articleId", onDelete: "cascade" });

      // Tag list
      this.belongsToMany(Tag, {
        through: "TagList",
        as: "tagList",
        foreignKey: "articleId",
        timestamps: false,
        onDelete: "cascade",
      });

      // Favorites
      this.belongsToMany(User, {
        through: "Favorites",
        foreignKey: "articleId",
        timestamps: false,
      });
    }

    toJSON() {
      return {
        ...this.get(),
        id: undefined,
        userId: undefined,
      };
    }
  }
  Article.init(
    {
      slug: DataTypes.STRING,
      title: DataTypes.STRING,
      description: DataTypes.TEXT,
      body: DataTypes.TEXT,
      readingTime: {
        type: DataTypes.VIRTUAL(DataTypes.INTEGER),
        get() {
          const bodyContent = this.body || '';
          const wordCount = bodyContent.length;
          const minutes = Math.max(Math.ceil(wordCount / 200), 1);
          return minutes;
        }
      },
      readingCount: {
        type: DataTypes.VIRTUAL(DataTypes.INTEGER),
        get() {
          return Math.floor(Math.random() * 10000);
        }
      }
    },
    {
      sequelize,
      modelName: "Article",
    },
  );
  return Article;
};