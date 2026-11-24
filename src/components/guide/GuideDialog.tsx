/**
 * 新手指引（FAQ）：在哪买 API → 官方导出 → 常见坑。
 *
 * 文案纪律（交接文档 §一3）：任务入口用大白话，"Key 等于钱包"这类关键比喻保留；
 * 品牌词"盖进被子"只在情绪时刻出现，这里讲的是操作，就说操作。
 */

import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeGuide, useGuideDialog } from './guideDialogState.js'
import styles from './GuideDialog.module.css'

export const GuideDialog = () => {
  const t = useTranslate()
  const open = useGuideDialog((state) => state.open)
  const hasKey = useSettings((state) => state.apiKey !== null)

  if (!open) {
    return null
  }

  return (
    <Modal title={t('guideTitle')} onClose={closeGuide} closable>
      <div className={styles.body}>
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

        <div className={styles.pitfalls}>
          <div className={styles.stepTitle}>{t('guidePitfallsTitle')}</div>
          {(
            ['guidePitfall1', 'guidePitfall2', 'guidePitfall3', 'guidePitfall4'] as const
          ).map((key) => (
            <p key={key} className={styles.pitfall}>
              {t(key)}
            </p>
          ))}
        </div>

        <div className={styles.actions}>
          {!hasKey ? (
            <Button
              size="s"
              onClick={() => {
                closeGuide()
                openSettings('data')
              }}
            >
              {t('guideGoSettings')}
            </Button>
          ) : null}
          <Button size="s" variant="outlined" onClick={closeGuide}>
            {t('close')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
