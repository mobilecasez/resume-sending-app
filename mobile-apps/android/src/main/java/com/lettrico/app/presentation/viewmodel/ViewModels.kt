package com.lettrico.app.presentation.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.lettrico.app.data.api.AuthResponse
import com.lettrico.app.domain.usecase.LoginUseCase
import com.lettrico.app.domain.usecase.RegisterUseCase
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

data class AuthState(
    val isLoading: Boolean = false,
    val isLoggedIn: Boolean = false,
    val authToken: String? = null,
    val userName: String? = null,
    val error: String? = null
)

class AuthViewModel(
    private val loginUseCase: LoginUseCase,
    private val registerUseCase: RegisterUseCase
) : ViewModel() {
    
    private val _authState = MutableStateFlow(AuthState())
    val authState: StateFlow<AuthState> = _authState
    
    fun login(email: String, password: String) {
        viewModelScope.launch {
            _authState.value = _authState.value.copy(isLoading = true)
            
            loginUseCase(email, password).onSuccess { response ->
                _authState.value = AuthState(
                    isLoading = false,
                    isLoggedIn = true,
                    authToken = response.token,
                    userName = response.user.fullName
                )
            }.onFailure { error ->
                _authState.value = AuthState(
                    isLoading = false,
                    error = error.message ?: "Login failed"
                )
            }
        }
    }
    
    fun register(fullName: String, email: String, password: String) {
        viewModelScope.launch {
            _authState.value = _authState.value.copy(isLoading = true)
            
            registerUseCase(fullName, email, password).onSuccess { response ->
                _authState.value = AuthState(
                    isLoading = false,
                    isLoggedIn = true,
                    authToken = response.token,
                    userName = response.user.fullName
                )
            }.onFailure { error ->
                _authState.value = AuthState(
                    isLoading = false,
                    error = error.message ?: "Registration failed"
                )
            }
        }
    }
    
    fun logout() {
        _authState.value = AuthState()
    }
    
    fun clearError() {
        _authState.value = _authState.value.copy(error = null)
    }
}

class DashboardViewModel : ViewModel()

class ProfileViewModel : ViewModel()
