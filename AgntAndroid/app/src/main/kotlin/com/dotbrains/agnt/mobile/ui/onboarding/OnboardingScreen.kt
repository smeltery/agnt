package com.dotbrains.agnt.mobile.ui.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.dotbrains.agnt.mobile.R

/**
 * One-time intro before first QR scan. Mirrors the iOS paged, dark setup flow.
 */
@Composable
fun OnboardingScreen(
    onContinue: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var page by remember { mutableIntStateOf(0) }

    Box(
        modifier =
            modifier
                .fillMaxSize()
                .background(Color.Black)
                .statusBarsPadding()
                .navigationBarsPadding(),
    ) {
        OnboardingPage(
            page = page,
            modifier =
                Modifier
                    .fillMaxSize()
                    .padding(horizontal = 28.dp)
                    .padding(bottom = 154.dp),
        )

        Column(
            modifier =
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .background(
                        Brush.verticalGradient(
                            listOf(Color.Transparent, Color.Black.copy(alpha = 0.78f), Color.Black),
                        ),
                    )
                    .padding(horizontal = 24.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            OnboardingPageDots(page = page)
            Button(
                onClick = {
                    when (OnboardingFlowLogic.primaryActionForPage(page)) {
                        OnboardingPrimaryAction.Advance -> page += 1
                        OnboardingPrimaryAction.Finish -> onContinue()
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(999.dp),
                colors =
                    ButtonDefaults.buttonColors(
                        containerColor = Color.White,
                        contentColor = Color.Black,
                    ),
            ) {
                Text(
                    text = stringResource(OnboardingFlowLogic.ctaLabelRes(page)),
                    style = MaterialTheme.typography.labelLarge,
                )
            }
            if (page > 0) {
                TextButton(onClick = { page -= 1 }) {
                    Text("Back", color = Color.White.copy(alpha = 0.58f))
                }
            } else {
                Spacer(modifier = Modifier.height(32.dp))
            }
        }
    }
}

@Composable
private fun OnboardingPage(
    page: Int,
    modifier: Modifier = Modifier,
) {
    when (page) {
        0 ->
            WelcomePage(modifier)
        1 ->
            FeaturesPage(modifier)
        2 ->
            StepPage(
                stepNumber = 1,
                title = "Install Codex CLI",
                description = "The AI coding agent that lives in your terminal. agnt connects to it from your phone.",
                command = "npm install -g @openai/codex@latest",
                modifier = modifier,
            )
        3 ->
            StepPage(
                stepNumber = 2,
                title = "Install the Bridge",
                description = "A lightweight local bridge securely connects your computer to this phone.",
                command = "npm install -g @dotbrains/agnt@latest",
                caption = "Keep-awake starts disabled. You can enable it later in Settings.",
                modifier = modifier,
            )
        else ->
            StepPage(
                stepNumber = 3,
                title = "Start Pairing",
                description = "Run this on your computer. A QR code will appear in your terminal.",
                command = "agnt up",
                modifier = modifier,
            )
    }
}

@Composable
private fun WelcomePage(modifier: Modifier) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            modifier =
                Modifier
                    .size(78.dp)
                    .clip(RoundedCornerShape(20.dp))
                    .background(Color.White.copy(alpha = 0.08f))
                    .border(1.dp, Color.White.copy(alpha = 0.18f), RoundedCornerShape(20.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Text("ag", color = Color.White, style = MaterialTheme.typography.headlineMedium)
        }
        Spacer(modifier = Modifier.height(24.dp))
        Text("agnt", color = Color.White, style = MaterialTheme.typography.headlineLarge)
        Text(
            text = "Control Codex from your phone.",
            color = Color.White.copy(alpha = 0.54f),
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            text = "End-to-end encrypted",
            color = Color.White.copy(alpha = 0.50f),
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(top = 24.dp),
        )
    }
}

@Composable
private fun FeaturesPage(modifier: Modifier) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "What you get",
            color = Color.White,
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center,
        )
        Text(
            text = "Everything runs on your computer. Your phone is the remote.",
            color = Color.White.copy(alpha = 0.48f),
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 10.dp, bottom = 34.dp),
        )
        FeatureRow("Fast mode", "Lower-latency turns for quick interactions", Color(0xFFFFD84A))
        FeatureRow("Git from your phone", "Commit, push, pull, and switch branches", Color(0xFF34D399))
        FeatureRow("End-to-end encrypted", "The relay never sees your prompts or code", Color(0xFF22D3EE))
        FeatureRow("Voice mode", "Talk to Codex with speech-to-text", Color(0xFFA78BFA))
        FeatureRow("Subagents, skills and /commands", "Spawn and monitor parallel agents", Color(0xFFFB923C))
    }
}

@Composable
private fun FeatureRow(
    title: String,
    subtitle: String,
    color: Color,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier =
                Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(color.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center,
        ) {
            Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(color))
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(title, color = Color.White, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            Text(subtitle, color = Color.White.copy(alpha = 0.42f), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun StepPage(
    stepNumber: Int,
    title: String,
    description: String,
    command: String,
    modifier: Modifier = Modifier,
    caption: String? = null,
) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Surface(
            shape = RoundedCornerShape(22.dp),
            color = Color.White.copy(alpha = 0.06f),
            border = androidx.compose.foundation.BorderStroke(1.dp, Color(0xFFC7A65A).copy(alpha = 0.28f)),
            modifier = Modifier.size(82.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text(stepNumber.toString(), color = Color.White, style = MaterialTheme.typography.headlineMedium)
            }
        }
        Text(
            text = "STEP $stepNumber",
            color = Color(0xFFC7A65A).copy(alpha = 0.82f),
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(top = 34.dp),
        )
        Text(
            text = title,
            color = Color.White,
            style = MaterialTheme.typography.headlineMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 10.dp),
        )
        Text(
            text = description,
            color = Color.White.copy(alpha = 0.48f),
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 12.dp, bottom = 28.dp),
        )
        CommandCard(command)
        caption?.let {
            Text(
                text = it,
                color = Color.White.copy(alpha = 0.46f),
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(top = 10.dp),
            )
        }
    }
}

@Composable
private fun CommandCard(command: String) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = Color.White.copy(alpha = 0.08f),
        border = androidx.compose.foundation.BorderStroke(1.dp, Color.White.copy(alpha = 0.12f)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = command,
            color = Color.White.copy(alpha = 0.92f),
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 13.dp),
        )
    }
}

@Composable
private fun OnboardingPageDots(page: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(ONBOARDING_PAGE_COUNT) { index ->
            Box(
                modifier =
                    Modifier
                        .size(width = if (index == page) 24.dp else 8.dp, height = 8.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(if (index == page) Color.White else Color.White.copy(alpha = 0.18f)),
            )
        }
    }
}
