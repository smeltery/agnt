package com.smeltery.agnt.mobile.ui.onboarding

import com.smeltery.agnt.mobile.R
import kotlin.test.Test
import kotlin.test.assertEquals

class OnboardingFlowLogicTest {
    @Test
    fun primaryActionAdvancesUntilLastPage() {
        for (page in 0 until ONBOARDING_PAGE_COUNT - 1) {
            assertEquals(OnboardingPrimaryAction.Advance, OnboardingFlowLogic.primaryActionForPage(page))
        }
    }

    @Test
    fun primaryActionFinishesOnLastPage() {
        assertEquals(
            OnboardingPrimaryAction.Finish,
            OnboardingFlowLogic.primaryActionForPage(ONBOARDING_PAGE_COUNT - 1),
        )
    }

    @Test
    fun ctaLabelsMatchPageIndex() {
        assertEquals(R.string.onboarding_cta_get_started, OnboardingFlowLogic.ctaLabelRes(0))
        assertEquals(R.string.onboarding_cta_set_up, OnboardingFlowLogic.ctaLabelRes(1))
        assertEquals(R.string.onboarding_cta_continue, OnboardingFlowLogic.ctaLabelRes(2))
        assertEquals(R.string.onboarding_cta_continue, OnboardingFlowLogic.ctaLabelRes(3))
        assertEquals(R.string.onboarding_continue, OnboardingFlowLogic.ctaLabelRes(4))
    }
}
