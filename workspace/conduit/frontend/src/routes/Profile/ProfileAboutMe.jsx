import React from 'react'
import styles from './ProfileAboutMe.module.css'

const ProfileAboutMe = ({ user }) => {
  const userBio = user?.bio ?? ''

  return (
    <div className={styles.wrapper}>
      <h2 className={styles.sectionTitle}>个人简介</h2>
      {userBio.trim() ? (
        <div
          className={styles.bioRichContent}
          dangerouslySetInnerHTML={{ __html: userBio }}
        />
      ) : (
        <p className={styles.emptyTip}>该用户暂未填写个人简介</p>
      )}
    </div>
  )
}

export default ProfileAboutMe