package com.lettrico.app.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.lettrico.app.presentation.viewmodel.AuthViewModel
import com.lettrico.app.ui.screens.DashboardScreen
import com.lettrico.app.ui.screens.GenerateCoverLetterScreen
import com.lettrico.app.ui.screens.LoginScreen
import com.lettrico.app.ui.screens.ProfileScreen
import com.lettrico.app.ui.screens.RegisterScreen
import org.koin.androidx.compose.koinViewModel

sealed class Route(val route: String) {
    object Login : Route("login")
    object Register : Route("register")
    object Dashboard : Route("dashboard")
    object GenerateCoverLetter : Route("generate")
    object Profile : Route("profile")
}

@Composable
fun NavGraph() {
    val navController = rememberNavController()
    val authViewModel: AuthViewModel = koinViewModel()
    val authState = authViewModel.authState.collectAsState()
    
    val startDestination = if (authState.value.isLoggedIn) {
        Route.Dashboard.route
    } else {
        Route.Login.route
    }
    
    NavHost(navController = navController, startDestination = startDestination) {
        composable(Route.Login.route) {
            LoginScreen(navController, authViewModel)
        }
        
        composable(Route.Register.route) {
            RegisterScreen(navController, authViewModel)
        }
        
        composable(Route.Dashboard.route) {
            DashboardScreen(navController, authViewModel)
        }
        
        composable(Route.GenerateCoverLetter.route) {
            GenerateCoverLetterScreen(navController)
        }
        
        composable(Route.Profile.route) {
            ProfileScreen(navController, authViewModel)
        }
    }
}
