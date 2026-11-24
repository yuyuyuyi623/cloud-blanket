/**
 * 首启引导：只在无 Key 访客点「随便聊聊」时出现（羽翼 2026-11-24 拍板：进站不自动弹任何窗）。
 *
 * 替代旧的"没 Key 就硬弹设置"和"挂载即自动弹"——三步走完的入口都在引导里：
 * 去设置填 Key / 先看看指引 / 先跳过。开合状态见 welcomeDialogState.ts。
 */

import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { useWelcomeDialog, closeWelcome } from './welcomeDialogState.js'
import { openGuide } from './guideDialogState.js'
import styles from './GuideDialog.module.css'

export const WelcomeDialog = () => {
  const t = useTranslate()
  const open = useWelcomeDialog((state) => state.open)

  // 必须订阅自己的 open 状态、关闭时 return null（交接文档 §四-1：否则关不掉、钉在屏幕上）
  if (!open) {
    return null
  }

  return (
    <Modal title={t('welcomeTitle')} onClose={closeWelcome} closable>
      <div className={styles.body}>
        <p className={styles.stepBody}>{t('welcomeBody')}</p>

        <div className={styles.step}>
          <div className={styles.stepTitle}>{t('guideStep1Title')}</div>
          <p className={styles.stepBody}>{t('guideStep1Body')}</p>
        </div>
        <div className={styles.step}>
          <div className={styles.stepTitle}>{t('guideStep2Title')}</div>
          <p className={styles.stepBody}>{t('guideStep2Body')}</p>
        </div>
        <div className={styles.step}>
          <div className={styles.stepTitle}>{t('guideStep3Title')}</div>
          <p className={styles.stepBody}>{t('guideStep3Body')}</p>
        </div>

        <div className={styles.actions}>
          <Button
            size="s"
            variant="outlined"
            onClick={() => {
              closeWelcome()
              openGuide()
            }}
          >
            {t('guideLinkTitle')}
          </Button>
          <Button size="s" variant="outlined" onClick={closeWelcome}>
            {t('welcomeSkip')}
          </Button>
          <Button
            size="s"
            onClick={() => {
              closeWelcome()
              openSettings('data')
            }}
          >
            {t('guideGoSettings')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
